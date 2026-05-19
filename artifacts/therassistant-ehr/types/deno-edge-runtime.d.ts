declare module "https://deno.land/std@0.208.0/http/server.ts" {
  export function serve(handler: (request: Request) => Response | Promise<Response>): void;
}

declare module "https://deno.land/std@0.224.0/http/server.ts" {
  export function serve(handler: (request: Request) => Response | Promise<Response>): void;
}

declare module "npm:@supabase/supabase-js@2" {
  export * from "@supabase/supabase-js";
}

declare global {
  const Deno: {
    serve(handler: (request: Request) => Response | Promise<Response>): void;
    env: {
      get(key: string): string | undefined;
    };
  };
}

export {};
