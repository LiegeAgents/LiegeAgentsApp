import { app } from "./app.js";
import { env } from "./config.js";
import { db } from "./db/index.js";
import { migrate } from "./db/migrate.js";
import { startAcpProvider, stopAcpProvider } from "./acp.js";
import { startSuperAgentsBot, stopSuperAgentsBot } from "./superAgentsBot.js";

await migrate();
const server = app.listen(env.PORT, () => console.log(`Liege API listening on :${env.PORT}`));
void startAcpProvider();
startSuperAgentsBot();

// Let in-flight requests finish and close the pool before the platform stops the container.
const shutdown = () =>
  server.close(
    () =>
      void stopAcpProvider().finally(() => {
        stopSuperAgentsBot();
        void db.end();
      }),
  );
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
