export const toJobSpecialty = (row) => ({
  id: row.id,
  userId: row.user_id,
  catalogSpecialtyId: row.specialty_id,
  name: row.name,
  createdAt: row.created_at,
})
