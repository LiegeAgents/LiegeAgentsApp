import { app } from "./app.js";
import { env } from "./config.js";
import { db } from "./db/index.js";
import { migrate } from "./db/migrate.js";

await migrate();
const server = app.listen(env.PORT, () => console.log(`Liege API listening on :${env.PORT}`));

// Let in-flight requests finish and close the pool before the platform stops the container.
const shutdown = () => server.close(() => void db.end());
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
