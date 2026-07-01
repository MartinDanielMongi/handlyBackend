import dotenv from 'dotenv'

dotenv.config()

export const port = process.env.PORT || 3001
export const sessionSecret = process.env.SESSION_SECRET || process.env.DATABASE_URL || 'jobdelivery-dev-secret'
export const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3002'
export const googleClientId = process.env.GOOGLE_CLIENT_ID || ''
export const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET || ''
export const googleRedirectUri = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${port}/api/auth/google/callback`
export const premiumDemoEnabled = process.env.PREMIUM_DEMO_ENABLED === 'true'
  || (process.env.PREMIUM_DEMO_ENABLED !== 'false' && process.env.NODE_ENV !== 'production')
