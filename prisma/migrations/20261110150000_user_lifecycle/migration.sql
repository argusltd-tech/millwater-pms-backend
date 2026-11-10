-- AlterEnum
ALTER TYPE "UserStatus" ADD VALUE 'deleted';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "lastLoginAt" TIMESTAMP(3);

