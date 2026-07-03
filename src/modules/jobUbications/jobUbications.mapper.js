const parseRatingComments = (value) => {
  if (!value) {
    return []
  }

  try {
    const serialized = Buffer.isBuffer(value) ? value.toString('utf8') : value
    const parsed = typeof serialized === 'string' ? JSON.parse(serialized) : serialized
    const comments = Array.isArray(parsed) ? parsed : []

    return comments
      .map((comment) => ({
        id: comment.id,
        score: Number(comment.score),
        comment: comment.comment || '',
        raterName: comment.raterName || 'Usuario',
        createdAt: comment.createdAt || null,
      }))
      .filter((comment) => comment.comment)
  } catch {
    return []
  }
}

export const toJobUbication = (row) => ({
  id: row.id,
  userId: row.user_id,
  specialtyId: row.specialty_id,
  catalogSpecialtyId: row.catalog_specialty_id || null,
  specialtyName: row.specialty_name || null,
  providerName: row.provider_name || null,
  providerAvatarUrl: row.provider_avatar_url || null,
  providerContactPhone: row.provider_contact_phone || '',
  providerWorkHours: row.provider_work_hours || '',
  providerProfileDescription: row.provider_profile_description || '',
  providerIsPremium: Boolean(Number(row.provider_is_premium || 0)),
  provider_is_premium: Boolean(Number(row.provider_is_premium || 0)),
  providerRatingAverage: row.provider_rating_average === null || row.provider_rating_average === undefined
    ? null
    : Number(row.provider_rating_average),
  providerRatingCount: Number(row.provider_rating_count || 0),
  providerRatingComments: parseRatingComments(row.provider_rating_comments),
  canViewPrivateProfile: row.can_view_private_profile === undefined
    ? true
    : Boolean(Number(row.can_view_private_profile)),
  latitude: Number(row.latitude),
  longitude: Number(row.longitude),
  radiusMeters: Number(row.radius_meters || 1500),
  distanceMeters: row.distance_meters === undefined ? null : Math.round(Number(row.distance_meters)),
  label: row.label,
  createdAt: row.created_at,
})
