import { db } from './connection.js'

const defaultSpecialties = [
  'Acompañante terapéutico',
  'Aire acondicionado',
  'Albañil',
  'Apoyo escolar',
  'Carpintero',
  'Cerrajero',
  'Clases de computación',
  'Clases de idiomas',
  'Clases de música',
  'Cocinero',
  'Colocación de durlock',
  'Colocación de pisos',
  'Cuidador',
  'Cuidador de adultos mayores',
  'Cuidador de mascotas',
  'Electricista',
  'Entrenador personal',
  'Fletes y mudanzas',
  'Fumigación',
  'Gasista',
  'Herrería',
  'Impermeabilización',
  'Instalación de alarmas',
  'Instalación de cámaras',
  'Instalación de internet',
  'Jardinería',
  'Limpieza',
  'Manicura',
  'Masajista',
  'Mantenimiento de piletas',
  'Mecánico',
  'Niñera',
  'Peluquería',
  'Pintor',
  'Plomería',
  'Profesor',
  'Profesor particular',
  'Refrigeración',
  'Reparación de celulares',
  'Reparación de electrodomésticos',
  'Reparación de lavarropas',
  'Reparación de muebles',
  'Soldador',
  'Tapicería',
  'Techista',
  'Técnico PC',
  'Vidriero',
  'Yesero',
]

const specialtyNameCorrections = [
  ['Acompanante terapeutico', 'Acompañante terapéutico'],
  ['Albanil', 'Albañil'],
  ['Clases de computacion', 'Clases de computación'],
  ['Clases de musica', 'Clases de música'],
  ['Colocacion de durlock', 'Colocación de durlock'],
  ['Colocacion de pisos', 'Colocación de pisos'],
  ['Fumigacion', 'Fumigación'],
  ['Herreria', 'Herrería'],
  ['Impermeabilizacion', 'Impermeabilización'],
  ['Instalacion de alarmas', 'Instalación de alarmas'],
  ['Instalacion de camaras', 'Instalación de cámaras'],
  ['Instalacion de internet', 'Instalación de internet'],
  ['Jardineria', 'Jardinería'],
  ['Mecanico', 'Mecánico'],
  ['Ninera', 'Niñera'],
  ['Peluqueria', 'Peluquería'],
  ['Plomeria', 'Plomería'],
  ['Refrigeracion', 'Refrigeración'],
  ['Reparacion de celulares', 'Reparación de celulares'],
  ['Reparacion de electrodomesticos', 'Reparación de electrodomésticos'],
  ['Reparacion de lavarropas', 'Reparación de lavarropas'],
  ['Reparacion de muebles', 'Reparación de muebles'],
  ['Tapiceria', 'Tapicería'],
  ['Tecnico PC', 'Técnico PC'],
]

const columnExists = async (tableName, columnName) => {
  const [columns] = await db.execute(`
    SELECT COLUMN_NAME
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ?
      AND COLUMN_NAME = ?
  `, [tableName, columnName])

  return columns.length > 0
}

const indexExists = async (tableName, indexName) => {
  const [indexes] = await db.execute(`
    SELECT INDEX_NAME
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ?
      AND INDEX_NAME = ?
  `, [tableName, indexName])

  return indexes.length > 0
}

const columnDataType = async (tableName, columnName) => {
  const [columns] = await db.execute(`
    SELECT DATA_TYPE
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ?
      AND COLUMN_NAME = ?
  `, [tableName, columnName])

  return columns[0]?.DATA_TYPE || ''
}

const foreignKeyExists = async (tableName, columnName, referencedTableName) => {
  const [constraints] = await db.execute(`
    SELECT CONSTRAINT_NAME
    FROM information_schema.KEY_COLUMN_USAGE
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ?
      AND COLUMN_NAME = ?
      AND REFERENCED_TABLE_NAME = ?
  `, [tableName, columnName, referencedTableName])

  return constraints.length > 0
}

const seedSpecialties = async () => {
  if (process.env.SEED_DEFAULT_SPECIALTIES === 'false') {
    return
  }

  const placeholders = defaultSpecialties.map(() => '(?)').join(', ')

  await db.execute(
    `INSERT IGNORE INTO specialties (name) VALUES ${placeholders}`,
    defaultSpecialties,
  )

  await db.execute(`
    INSERT IGNORE INTO specialties (name)
    SELECT DISTINCT name
    FROM jobSpecialties
    WHERE name IS NOT NULL AND name <> ''
  `)
}

const normalizeSpecialtyNames = async () => {
  for (const [previousName, nextName] of specialtyNameCorrections) {
    await db.execute(
      'UPDATE specialties SET name = ? WHERE name = ?',
      [nextName, previousName],
    )

    await db.execute(
      'UPDATE jobSpecialties SET name = ? WHERE name = ?',
      [nextName, previousName],
    )
  }
}

export const ensureDatabase = async () => {
  if (!db) {
    return
  }

  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      email VARCHAR(150) NOT NULL,
      password VARCHAR(255) NOT NULL,
      google_id VARCHAR(128) NULL,
      avatar_url LONGTEXT NULL,
      contact_phone VARCHAR(40) NULL,
      work_hours VARCHAR(160) NULL,
      profile_description VARCHAR(500) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY email (email),
      UNIQUE KEY users_google_id_unique (google_id)
    )
  `)

  if (!(await columnExists('users', 'google_id'))) {
    await db.execute('ALTER TABLE users ADD COLUMN google_id VARCHAR(128) NULL AFTER password')
  }

  if (!(await indexExists('users', 'users_google_id_unique'))) {
    await db.execute('ALTER TABLE users ADD UNIQUE KEY users_google_id_unique (google_id)')
  }

  if (!(await columnExists('users', 'avatar_url'))) {
    await db.execute('ALTER TABLE users ADD COLUMN avatar_url LONGTEXT NULL AFTER password')
  } else if ((await columnDataType('users', 'avatar_url')) !== 'longtext') {
    await db.execute('ALTER TABLE users MODIFY COLUMN avatar_url LONGTEXT NULL')
  }

  if (!(await columnExists('users', 'contact_phone'))) {
    await db.execute('ALTER TABLE users ADD COLUMN contact_phone VARCHAR(40) NULL AFTER avatar_url')
  }

  if (!(await columnExists('users', 'work_hours'))) {
    await db.execute('ALTER TABLE users ADD COLUMN work_hours VARCHAR(160) NULL AFTER contact_phone')
  }

  if (!(await columnExists('users', 'profile_description'))) {
    await db.execute('ALTER TABLE users ADD COLUMN profile_description VARCHAR(500) NULL AFTER work_hours')
  }

  if (!(await columnExists('users', 'premium_status'))) {
    await db.execute("ALTER TABLE users ADD COLUMN premium_status VARCHAR(30) NOT NULL DEFAULT 'free' AFTER profile_description")
  }

  if (!(await columnExists('users', 'premium_plan'))) {
    await db.execute('ALTER TABLE users ADD COLUMN premium_plan VARCHAR(40) NULL AFTER premium_status')
  }

  if (!(await columnExists('users', 'premium_started_at'))) {
    await db.execute('ALTER TABLE users ADD COLUMN premium_started_at TIMESTAMP NULL AFTER premium_plan')
  }

  if (!(await columnExists('users', 'premium_expires_at'))) {
    await db.execute('ALTER TABLE users ADD COLUMN premium_expires_at TIMESTAMP NULL AFTER premium_started_at')
  }

  await db.execute(`
    CREATE TABLE IF NOT EXISTS premiumSubscriptions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      plan_code VARCHAR(40) NOT NULL DEFAULT 'premium_monthly',
      status VARCHAR(30) NOT NULL DEFAULT 'active',
      provider VARCHAR(40) NULL,
      provider_subscription_id VARCHAR(150) NULL,
      current_period_start TIMESTAMP NULL,
      current_period_end TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX premiumSubscriptions_user_id_idx (user_id),
      INDEX premiumSubscriptions_status_idx (status),
      UNIQUE KEY premiumSubscriptions_provider_unique (provider, provider_subscription_id),
      FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE
    )
  `)

  await db.execute(`
    CREATE TABLE IF NOT EXISTS bugReports (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NULL,
      contact_email VARCHAR(150) NULL,
      description VARCHAR(1200) NOT NULL,
      page_url VARCHAR(500) NULL,
      user_agent VARCHAR(500) NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'open',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX bugReports_user_id_idx (user_id),
      INDEX bugReports_status_idx (status),
      FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE SET NULL
    )
  `)

  await db.execute(`
    CREATE TABLE IF NOT EXISTS jobRatings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      rater_user_id INT NOT NULL,
      rated_user_id INT NOT NULL,
      score TINYINT UNSIGNED NOT NULL,
      comment_text VARCHAR(800) NOT NULL DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX jobRatings_rater_user_id_idx (rater_user_id),
      INDEX jobRatings_rated_user_id_idx (rated_user_id),
      UNIQUE KEY jobRatings_rater_rated_unique (rater_user_id, rated_user_id),
      FOREIGN KEY (rater_user_id) REFERENCES users(id)
        ON DELETE CASCADE,
      FOREIGN KEY (rated_user_id) REFERENCES users(id)
        ON DELETE CASCADE
    )
  `)

  if (!(await columnExists('jobRatings', 'comment_text'))) {
    await db.execute("ALTER TABLE jobRatings ADD COLUMN comment_text VARCHAR(800) NOT NULL DEFAULT '' AFTER score")
  }

  await db.execute(`
    CREATE TABLE IF NOT EXISTS specialties (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY specialties_name_unique (name)
    )
  `)

  await db.execute(`
    CREATE TABLE IF NOT EXISTS jobSpecialties (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      specialty_id INT NULL,
      name VARCHAR(100) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX jobSpecialties_user_id_idx (user_id),
      INDEX jobSpecialties_specialty_id_idx (specialty_id),
      UNIQUE KEY jobSpecialties_user_name_unique (user_id, name),
      FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE,
      FOREIGN KEY (specialty_id) REFERENCES specialties(id)
        ON DELETE CASCADE
    )
  `)

  if (!(await columnExists('jobSpecialties', 'specialty_id'))) {
    await db.execute('ALTER TABLE jobSpecialties ADD COLUMN specialty_id INT NULL AFTER user_id')
  }

  if (!(await indexExists('jobSpecialties', 'jobSpecialties_specialty_id_idx'))) {
    await db.execute('ALTER TABLE jobSpecialties ADD INDEX jobSpecialties_specialty_id_idx (specialty_id)')
  }

  if (!(await indexExists('jobSpecialties', 'jobSpecialties_user_specialty_unique'))) {
    await db.execute('ALTER TABLE jobSpecialties ADD UNIQUE KEY jobSpecialties_user_specialty_unique (user_id, specialty_id)')
  }

  await seedSpecialties()
  await normalizeSpecialtyNames()

  await db.execute(`
    UPDATE jobSpecialties
    INNER JOIN specialties
      ON specialties.name = jobSpecialties.name
    SET jobSpecialties.specialty_id = specialties.id
    WHERE jobSpecialties.specialty_id IS NULL
  `)

  if (!(await foreignKeyExists('jobSpecialties', 'specialty_id', 'specialties'))) {
    await db.execute(`
      ALTER TABLE jobSpecialties
      ADD FOREIGN KEY (specialty_id) REFERENCES specialties(id)
    `)
  }

  await db.execute(`
    CREATE TABLE IF NOT EXISTS jobUbications (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      specialty_id INT NULL,
      latitude DECIMAL(10, 7) NOT NULL,
      longitude DECIMAL(10, 7) NOT NULL,
      radius_meters INT NOT NULL DEFAULT 1500,
      label VARCHAR(120) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX jobUbications_user_id_idx (user_id),
      INDEX jobUbications_specialty_id_idx (specialty_id),
      FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE,
      FOREIGN KEY (specialty_id) REFERENCES jobSpecialties(id)
        ON DELETE CASCADE
    )
  `)

  if (!(await columnExists('jobUbications', 'specialty_id'))) {
    await db.execute('ALTER TABLE jobUbications ADD COLUMN specialty_id INT NULL AFTER user_id')
  }

  if (!(await columnExists('jobUbications', 'radius_meters'))) {
    await db.execute('ALTER TABLE jobUbications ADD COLUMN radius_meters INT NOT NULL DEFAULT 1500 AFTER longitude')
  }

  if (!(await indexExists('jobUbications', 'jobUbications_specialty_id_idx'))) {
    await db.execute('ALTER TABLE jobUbications ADD INDEX jobUbications_specialty_id_idx (specialty_id)')
  }

  if (!(await foreignKeyExists('jobUbications', 'specialty_id', 'jobSpecialties'))) {
    await db.execute(`
      ALTER TABLE jobUbications
      ADD FOREIGN KEY (specialty_id) REFERENCES jobSpecialties(id)
      ON DELETE CASCADE
    `)
  }
}
