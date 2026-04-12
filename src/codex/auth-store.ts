import type { DatabaseClient } from "../db/client.js";
import type { Clock } from "../shared/clock.js";
import { SecretBox } from "../shared/crypto.js";
import type { AuthProfile, AuthProfileSource } from "./types.js";

type AuthProfileRow = {
  profile_id: string;
  provider: "openai-codex";
  source: AuthProfileSource;
  access_token_ciphertext: string | null;
  refresh_token_ciphertext: string | null;
  expires_at: number | null;
  account_id: string | null;
  email: string | null;
  display_name: string | null;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
};

function parseMetadata(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export class AuthProfileStore {
  constructor(
    private readonly database: DatabaseClient,
    private readonly clock: Clock,
    private readonly secretBox: SecretBox,
  ) {}

  list(): AuthProfile[] {
    const rows = this.database.db
      .prepare<unknown[], AuthProfileRow>("select * from auth_profiles order by updated_at desc")
      .all();
    return rows.map((row) => this.mapRow(row));
  }

  get(profileId: string): AuthProfile | undefined {
    const row = this.database.db
      .prepare<unknown[], AuthProfileRow>("select * from auth_profiles where profile_id = ?")
      .get(profileId);
    return row ? this.mapRow(row) : undefined;
  }

  upsert(params: {
    profileId: string;
    source: AuthProfileSource;
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    accountId?: string;
    email?: string;
    displayName?: string;
    metadata?: Record<string, unknown>;
  }): AuthProfile {
    const existing = this.get(params.profileId);
    const now = this.clock.now();
    const row = {
      profile_id: params.profileId,
      provider: "openai-codex" as const,
      source: params.source,
      access_token_ciphertext: params.accessToken ? this.secretBox.seal(params.accessToken) : null,
      refresh_token_ciphertext: params.refreshToken ? this.secretBox.seal(params.refreshToken) : null,
      expires_at: params.expiresAt ?? null,
      account_id: params.accountId ?? null,
      email: params.email ?? null,
      display_name: params.displayName ?? null,
      metadata_json: params.metadata ? JSON.stringify(params.metadata) : null,
      created_at: existing?.createdAt ?? now,
      updated_at: now,
    };
    this.database.db
      .prepare(
        `insert into auth_profiles (
          profile_id, provider, source, access_token_ciphertext, refresh_token_ciphertext, expires_at, account_id, email, display_name, metadata_json, created_at, updated_at
        ) values (
          @profile_id, @provider, @source, @access_token_ciphertext, @refresh_token_ciphertext, @expires_at, @account_id, @email, @display_name, @metadata_json, @created_at, @updated_at
        )
        on conflict(profile_id) do update set
          provider = excluded.provider,
          source = excluded.source,
          access_token_ciphertext = excluded.access_token_ciphertext,
          refresh_token_ciphertext = excluded.refresh_token_ciphertext,
          expires_at = excluded.expires_at,
          account_id = excluded.account_id,
          email = excluded.email,
          display_name = excluded.display_name,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at`,
      )
      .run(row);
    return this.get(params.profileId)!;
  }

  private mapRow(row: AuthProfileRow): AuthProfile {
    return {
      profileId: row.profile_id,
      provider: row.provider,
      source: row.source,
      ...(row.access_token_ciphertext
        ? { accessToken: this.secretBox.open(row.access_token_ciphertext) }
        : {}),
      ...(row.refresh_token_ciphertext
        ? { refreshToken: this.secretBox.open(row.refresh_token_ciphertext) }
        : {}),
      ...(row.expires_at !== null ? { expiresAt: row.expires_at } : {}),
      ...(row.account_id ? { accountId: row.account_id } : {}),
      ...(row.email ? { email: row.email } : {}),
      ...(row.display_name ? { displayName: row.display_name } : {}),
      ...(row.metadata_json ? { metadata: parseMetadata(row.metadata_json) } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
