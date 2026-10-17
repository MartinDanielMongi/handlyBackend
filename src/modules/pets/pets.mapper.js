export const toPet = (row) => ({
  id: row.id,
  userId: row.user_id,
  status: row.status,
  type: row.type,
  name: row.name || '',
  breed: row.breed || '',
  collar: row.collar || '',
  description: row.description || '',
  photoUrl: row.photo_url || '',
  latitude: row.latitude === null || row.latitude === undefined ? null : Number(row.latitude),
  longitude: row.longitude === null || row.longitude === undefined ? null : Number(row.longitude),
  radiusMeters: Number(row.radius_meters || 1500),
  ownerName: row.owner_name || '',
  ownerAvatarUrl: row.owner_avatar_url || '',
  ownerContactPhone: row.owner_contact_phone || '',
  distanceMeters: row.distance_meters === undefined || row.distance_meters === null
    ? null
    : Math.round(Number(row.distance_meters)),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})
