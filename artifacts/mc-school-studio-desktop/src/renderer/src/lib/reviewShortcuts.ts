export type ReviewRating = 1 | 2 | 3 | 4 | 5

export function ratingFromShortcut(key: string): ReviewRating | null {
  if (!/^[1-5]$/.test(key)) return null
  return Number(key) as ReviewRating
}