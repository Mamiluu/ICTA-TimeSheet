-- The organisation's official top account. Added on its own, in its own
-- migration: a new enum value cannot be used until the statement that adds it
-- has committed, and the next migration backfills data in the same release.
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'PLATFORM_ADMIN';
