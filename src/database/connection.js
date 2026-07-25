import mysql from 'mysql2/promise'
import { databaseUrl } from '../config/env.js'

export const db = databaseUrl ? mysql.createPool(databaseUrl) : null

export const ensureDb = (res) => {
  if (db) {
    return true
  }

  res.status(500).json({ message: 'DATABASE_URL no esta configurada.' })
  return false
}
