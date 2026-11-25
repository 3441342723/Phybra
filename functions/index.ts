import { handler } from "./handler.ts";

Deno.serve((request) => handler(request));
