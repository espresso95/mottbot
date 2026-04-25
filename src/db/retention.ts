import type { DatabaseClient } from "./client.js";

/** Timestamp cutoffs used to decide which operational records are old enough to prune. */
type OperationalRetentionCutoffs = {
  telegramUpdatesBefore: number;
  messagesBefore: number;
  attachmentRecordsBefore: number;
  telegramBotMessagesBefore: number;
  outboxMessagesBefore: number;
  terminalRunsBefore: number;
};

/** Counts returned after a retention pass or dry run. */
type OperationalRetentionResult = {
  dryRun: boolean;
  cutoffs: OperationalRetentionCutoffs;
  telegramUpdates: number;
  messages: number;
  attachmentRecords: number;
  telegramBotMessages: number;
  outboxMessages: number;
  runQueue: number;
  runs: number;
};

const TERMINAL_RUN_STATUSES = ["completed", "failed", "cancelled"] as const;
const ACTIVE_RUN_STATUSES = ["queued", "starting", "streaming"] as const;

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

/** Builds aligned retention cutoffs from a single age threshold in days. */
export function buildOperationalRetentionCutoffs(params: {
  now: number;
  olderThanDays: number;
}): OperationalRetentionCutoffs {
  if (!Number.isInteger(params.olderThanDays) || params.olderThanDays < 1) {
    throw new Error("olderThanDays must be a positive integer.");
  }
  const cutoff = params.now - params.olderThanDays * 24 * 60 * 60 * 1000;
  return {
    telegramUpdatesBefore: cutoff,
    messagesBefore: cutoff,
    attachmentRecordsBefore: cutoff,
    telegramBotMessagesBefore: cutoff,
    outboxMessagesBefore: cutoff,
    terminalRunsBefore: cutoff,
  };
}

function count(database: DatabaseClient, table: string, whereSql: string, params: unknown[]): number {
  const row = database.db
    .prepare<unknown[], { count: number }>(`select count(*) as count from ${table} where ${whereSql}`)
    .get(...params);
  return row?.count ?? 0;
}

function remove(database: DatabaseClient, table: string, whereSql: string, params: unknown[]): number {
  return database.db.prepare(`delete from ${table} where ${whereSql}`).run(...params).changes;
}

/** Deletes or counts old operational rows without removing active run context. */
export function pruneOperationalData(params: {
  database: DatabaseClient;
  cutoffs: OperationalRetentionCutoffs;
  dryRun?: boolean;
}): OperationalRetentionResult {
  const terminalStatusSql = placeholders(TERMINAL_RUN_STATUSES);
  const activeStatusSql = placeholders(ACTIVE_RUN_STATUSES);
  const terminalRunIdsSql = `
    select r.run_id
    from runs r
    where r.status in (${terminalStatusSql})
      and coalesce(r.finished_at, r.updated_at, r.created_at) < ?
      and not exists (
        select 1
        from outbox_messages o
        where o.run_id = r.run_id
          and (o.state = 'active' or o.updated_at >= ?)
      )
      and not exists (
        select 1
        from telegram_bot_messages b
        where b.run_id = r.run_id
          and b.created_at >= ?
      )
      and not exists (
        select 1
        from messages m
        where m.run_id = r.run_id
          and m.created_at >= ?
      )`;
  const terminalRunParams = [
    ...TERMINAL_RUN_STATUSES,
    params.cutoffs.terminalRunsBefore,
    params.cutoffs.outboxMessagesBefore,
    params.cutoffs.telegramBotMessagesBefore,
    params.cutoffs.messagesBefore,
  ];
  const activeRunIdsSql = `select run_id from runs where status in (${activeStatusSql})`;
  const activeRunParams = [...ACTIVE_RUN_STATUSES];

  const where = {
    telegramUpdates: {
      sql: "processed_at < ?",
      params: [params.cutoffs.telegramUpdatesBefore],
    },
    messages: {
      sql: `created_at < ?
        and (
          run_id is null
          or run_id not in (${activeRunIdsSql})
          or run_id in (${terminalRunIdsSql})
        )`,
      params: [params.cutoffs.messagesBefore, ...activeRunParams, ...terminalRunParams],
    },
    telegramBotMessages: {
      sql: `created_at < ?
        and (
          run_id is null
          or run_id not in (${activeRunIdsSql})
          or run_id in (${terminalRunIdsSql})
        )`,
      params: [params.cutoffs.telegramBotMessagesBefore, ...activeRunParams, ...terminalRunParams],
    },
    attachmentRecords: {
      sql: `created_at < ?
        and (
          run_id is null
          or run_id not in (${activeRunIdsSql})
          or run_id in (${terminalRunIdsSql})
        )`,
      params: [params.cutoffs.attachmentRecordsBefore, ...activeRunParams, ...terminalRunParams],
    },
    outboxMessages: {
      sql: `(state != 'active' and updated_at < ? and run_id not in (${activeRunIdsSql}))
        or run_id in (${terminalRunIdsSql})`,
      params: [params.cutoffs.outboxMessagesBefore, ...activeRunParams, ...terminalRunParams],
    },
    runQueue: {
      sql: `updated_at < ? and state in ('completed', 'failed')
        or run_id in (${terminalRunIdsSql})`,
      params: [params.cutoffs.terminalRunsBefore, ...terminalRunParams],
    },
    runs: {
      sql: `run_id in (${terminalRunIdsSql})`,
      params: terminalRunParams,
    },
  };

  const counts = {
    telegramUpdates: count(
      params.database,
      "telegram_updates",
      where.telegramUpdates.sql,
      where.telegramUpdates.params,
    ),
    messages: count(params.database, "messages", where.messages.sql, where.messages.params),
    attachmentRecords: count(
      params.database,
      "attachment_records",
      where.attachmentRecords.sql,
      where.attachmentRecords.params,
    ),
    telegramBotMessages: count(
      params.database,
      "telegram_bot_messages",
      where.telegramBotMessages.sql,
      where.telegramBotMessages.params,
    ),
    outboxMessages: count(params.database, "outbox_messages", where.outboxMessages.sql, where.outboxMessages.params),
    runQueue: count(params.database, "run_queue", where.runQueue.sql, where.runQueue.params),
    runs: count(params.database, "runs", where.runs.sql, where.runs.params),
  };

  if (params.dryRun ?? true) {
    return {
      dryRun: true,
      cutoffs: params.cutoffs,
      ...counts,
    };
  }

  const deleted = params.database.db.transaction(() => {
    const telegramUpdates = remove(
      params.database,
      "telegram_updates",
      where.telegramUpdates.sql,
      where.telegramUpdates.params,
    );
    const messages = remove(params.database, "messages", where.messages.sql, where.messages.params);
    const attachmentRecords = remove(
      params.database,
      "attachment_records",
      where.attachmentRecords.sql,
      where.attachmentRecords.params,
    );
    const telegramBotMessages = remove(
      params.database,
      "telegram_bot_messages",
      where.telegramBotMessages.sql,
      where.telegramBotMessages.params,
    );
    const outboxMessages = remove(
      params.database,
      "outbox_messages",
      where.outboxMessages.sql,
      where.outboxMessages.params,
    );
    const runQueue = remove(params.database, "run_queue", where.runQueue.sql, where.runQueue.params);
    const runs = remove(params.database, "runs", where.runs.sql, where.runs.params);
    return {
      telegramUpdates,
      messages,
      attachmentRecords,
      telegramBotMessages,
      outboxMessages,
      runQueue,
      runs,
    };
  })();

  return {
    dryRun: false,
    cutoffs: params.cutoffs,
    ...deleted,
  };
}
