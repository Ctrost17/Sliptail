export type Category = 'Music' | 'Art' | 'Fitness' | 'Gaming' | 'Education' | 'Cooking' | 'Other'
export type ProductType = 'purchase' | 'request' | 'membership'

export interface Product {
  id: string
  title: string
  description?: string
  price: number            // cents (DB column is named "price")
  product_type: ProductType
  fileUrl?: string         // for purchases (digital download)
}

export interface Review {
  id: string
  authorDisplay: string
  rating: number           // 1-5
  text?: string
  createdAt: string
}

export interface Creator {
  id: string
  displayName: string
  bio: string
  avatarUrl: string
  categories: Category[]
  rating: number
  images4: string[]        // back of card & profile gallery
  products: Product[]
  reviews: Review[]
}

export interface RequestItem {
  id: string
  buyerDisplay: string
  note?: string
  fileUrl?: string
  status: 'pending' | 'completed'
}

export interface MembershipPost {
  id: string
  creatorId: string
  createdAt: string
  mediaUrl?: string
  text?: string
}