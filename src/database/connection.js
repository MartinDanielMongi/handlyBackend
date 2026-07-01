import mysql from 'mysql2/promise'
import '../config/env.js'

export const db = process.env.DATABASE_URL ? mysql.createPool(process.env.DATABASE_URL) : null

export const ensureDb = (res) => {
  if (db) {
    return true
  }

  res.status(500).json({ message: 'DATABASE_URL no esta configurada.' })
  return false
}
