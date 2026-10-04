declare namespace Cloudflare {
  interface Env {
    ORS_API_KEY?: string;
  }
}

declare module 'cloudflare:workers' {
  export const env: Cloudflare.Env;
}
