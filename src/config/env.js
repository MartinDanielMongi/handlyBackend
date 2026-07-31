import dotenv from 'dotenv'

dotenv.config()

export const port = process.env.PORT || 3001
// Railway's MySQL service commonly exposes MYSQL_URL. DATABASE_URL is kept as
// the preferred application-level name so the same code works locally and in
// other hosts.
export const databaseUrl = process.env.DATABASE_URL || process.env.MYSQL_URL || ''
export const sessionSecret = process.env.SESSION_SECRET || 'jobdelivery-dev-secret'
export const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3002'
export const allowedOrigins = frontendUrl
  .split(',')
  .map((url) => url.trim().replace(/\/$/, ''))
  .filter(Boolean)
export const googleClientId = process.env.GOOGLE_CLIENT_ID || ''
export const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET || ''
export const googleRedirectUri = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${port}/api/auth/google/callback`
export const resendApiKey = process.env.RESEND_API_KEY || ''
export const resetEmailFrom = process.env.RESET_EMAIL_FROM || ''
export const bugReportNotificationEmail = process.env.BUG_REPORT_NOTIFICATION_EMAIL || ''
export const premiumDemoEnabled = process.env.PREMIUM_DEMO_ENABLED === 'true'
  || (process.env.PREMIUM_DEMO_ENABLED !== 'false' && process.env.NODE_ENV !== 'production')
