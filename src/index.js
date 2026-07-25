import express from 'express'
import cors from 'cors'
import { allowedOrigins, port } from './config/env.js'
import { db } from './database/connection.js'
import { ensureDatabase } from './database/schema.js'
import { authRouter } from './modules/auth/auth.routes.js'
import { bugReportsRouter } from './modules/bugReports/bugReports.routes.js'
import { healthRouter } from './modules/health/health.routes.js'
import { jobSpecialtiesRouter } from './modules/jobSpecialties/jobSpecialties.routes.js'
import { jobUbicationsRouter } from './modules/jobUbications/jobUbications.routes.js'
import { premiumRouter } from './modules/premium/premium.routes.js'
import { ratingsRouter } from './modules/ratings/ratings.routes.js'
import { specialtiesRouter } from './modules/specialties/specialties.routes.js'

const app = express()

app.use(cors({
  origin(origin, callback) {
    // Requests without an Origin header include health checks and server-side
    // redirects, which do not need browser CORS protection.
    if (!origin || allowedOrigins.includes(origin.replace(/\/$/, ''))) {
      return callback(null, true)
    }

    return callback(new Error('Origen no autorizado por CORS.'))
  },
}))
app.use(express.json({ limit: '5mb' }))

app.use('/api', healthRouter)
app.use('/api', authRouter)
app.use('/api/bugReports', bugReportsRouter)
app.use('/api/specialties', specialtiesRouter)
app.use('/api/jobSpecialties', jobSpecialtiesRouter)
app.use('/api/jobUbications', jobUbicationsRouter)
app.use('/api/premium', premiumRouter)
app.use('/api/ratings', ratingsRouter)

ensureDatabase().then(() => {
  app.listen(port, () => {
    console.log(`API corriendo en http://localhost:${port}`)
  })
}).catch((error) => {
  console.error('No se pudo preparar la base de datos:', error)
  process.exit(1)
})

process.on('SIGINT', async () => {
  await db?.end()
  process.exit(0)
})
