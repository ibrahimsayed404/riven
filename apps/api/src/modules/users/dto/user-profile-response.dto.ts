import { Role } from '@prisma/client';

export type UserLocation = {
  lat: number;
  lng: number;
};

/**
 * Shared response shape for user profile endpoints.
 * Used by both GET /users/me and GET /admin/users/:id.
 * Never includes passwordHash — exclusion is enforced at the Prisma select level.
 */
export type UserProfileResponse = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  role: Role;
  interests: string[];
  /** false = suspended by an admin; the owner cannot sign in until reactivated. */
  isActive: boolean;
  location: UserLocation | null;
  createdAt: Date;
  updatedAt: Date;
};
