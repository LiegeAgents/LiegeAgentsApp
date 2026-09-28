import { app } from './app.js'
import { env } from './config.js'
import { migrate } from './db/migrate.js'

await migrate()
app.listen(env.PORT, () => console.log(`Liege API listening on :${env.PORT}`))
