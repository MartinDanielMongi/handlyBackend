import { db } from '../../database/connection.js'

export const freeSpecialtyLimit = 5
export const freePinsPerSpecialtyLimit = 4
export const premiumPinsPerSpecialtyLimit = 20

export const isPremiumUser = async (userId) => {
  const [users] = await db.execute(
    `SELECT
      CASE
        WHEN premium_status = 'active'
          AND (premium_expires_at IS NULL OR premium_expires_at > NOW())
        THEN 1
        ELSE 0
      END AS is_premium
    FROM users
    WHERE id = ?
    LIMIT 1`,
    [userId],
  )

  return Boolean(Number(users[0]?.is_premium || 0))
}

export const getUserLimits = async (userId) => {
  const isPremium = await isPremiumUser(userId)

  return {
    isPremium,
    specialtyLimit: isPremium ? null : freeSpecialtyLimit,
    pinsPerSpecialtyLimit: isPremium ? premiumPinsPerSpecialtyLimit : freePinsPerSpecialtyLimit,
  }
}
