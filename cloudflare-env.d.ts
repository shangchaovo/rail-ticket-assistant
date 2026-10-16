declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    ASSETS?: Fetcher;
    RAIL_AUTH_MODE?: string;
    RAIL_OWNER_ID?: string;
    RAIL_PASSWORD_HASH?: string;
    RAIL_SESSION_SECRET?: string;
    AI_ASSISTANT_ENABLED?: string;
    AI?: import('./cloud/public/assistant-model').AiBinding;
  }
}
