import { env } from "cloudflare:workers";
import { type FilesEnv, handleFiles } from "../../share/files.ts";

export default {
  async fetch(request) {
    return handleFiles(request, env as FilesEnv);
  },
} satisfies ExportedHandler;
