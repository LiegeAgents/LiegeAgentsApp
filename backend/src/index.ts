import { app } from "./app.js";
import { env } from "./config.js";
import { db } from "./db/index.js";
import { migrate } from "./db/migrate.js";
import { startAcpProvider, stopAcpProvider } from "./acp.js";
import { startSuperAgentsBot, stopSuperAgentsBot } from "./superAgentsBot.js";
import { startLiegeStakingPayoutExecutor } from "./stakingExecutor.js";
import { startSuperAgentScheduler, stopSuperAgentScheduler } from "./superAgentSchedules.js";
import { startReceiptAnchoring, stopReceiptAnchoring } from "./jobReceipts.js";
import { startCallSweeper, stopCallSweeper } from "./superAgentCalls.js";
import { startPayoutReleases, stopPayoutReleases } from "./challenges.js";
import { startMilestoneAdvances, stopMilestoneAdvances } from "./milestones.js";
import { startChainTriggers, stopChainTriggers } from "./chainTriggers.js";
import { startBalanceAlertPush, stopBalanceAlertPush } from "./telegram.js";

await migrate();
const server = app.listen(env.PORT, () => console.log(`Liege API listening on :${env.PORT}`));
void startAcpProvider();
startSuperAgentsBot();
startLiegeStakingPayoutExecutor();
startSuperAgentScheduler();
startReceiptAnchoring();
startCallSweeper();
startPayoutReleases();
startMilestoneAdvances();
startChainTriggers();
startBalanceAlertPush();

// Let in-flight requests finish and close the pool before the platform stops the container.
const shutdown = () =>
  server.close(
    () =>
      void stopAcpProvider().finally(() => {
        stopSuperAgentsBot();
        stopSuperAgentScheduler();
        stopReceiptAnchoring();
        stopCallSweeper();
        stopPayoutReleases();
        stopMilestoneAdvances();
        stopChainTriggers();
        stopBalanceAlertPush();
        void db.end();
      }),
  );
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
