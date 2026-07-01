import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback)

export const hashPassword = async (password) => {
  const salt = randomBytes(16).toString('hex')
  const passwordHash = await scrypt(password, salt, 64)

  return `scrypt:${salt}:${passwordHash.toString('hex')}`
}

export const verifyPassword = async (password, storedPassword) => {
  const [algorithm, salt, storedHash] = String(storedPassword).split(':')

  if (algorithm !== 'scrypt' || !salt || !storedHash) {
    return false
  }

  const passwordHash = await scrypt(password, salt, 64)
  const storedBuffer = Buffer.from(storedHash, 'hex')

  if (storedBuffer.length !== passwordHash.length) {
    return false
  }

  return timingSafeEqual(storedBuffer, passwordHash)
}
