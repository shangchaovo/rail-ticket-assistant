import { sqliteTable, text, integer, index, uniqueIndex, primaryKey } from 'drizzle-orm/sqlite-core';
import {sql} from 'drizzle-orm';
export const devices = sqliteTable('devices', {
  id:text('id').primaryKey(), ownerId:text('owner_id').notNull(), tokenHash:text('token_hash').notNull().unique(),
  name:text('name').notNull(), lastSeen:text('last_seen'), message:text('message').notNull().default(''), createdAt:text('created_at').notNull(),
  revokedAt:text('revoked_at'),runnerId:text('runner_id'),runnerUntil:text('runner_until'),resumeVersion:integer('resume_version').notNull().default(0),
}, t=>[index('devices_owner').on(t.ownerId),uniqueIndex('devices_one_active').on(t.ownerId).where(sql`${t.revokedAt} IS NULL`)]);
export const jobs = sqliteTable('jobs', {
  id:text('id').primaryKey(), ownerId:text('owner_id').notNull(), version:integer('version').notNull().default(1),
  status:text('status').notNull(), inputJson:text('input_json').notNull(), resultJson:text('result_json'),
  message:text('message').notNull(), mode:text('mode').notNull().default('search'), recheckJson:text('recheck_json'),
  deviceId:text('device_id'), leaseToken:text('lease_token'), leaseUntil:text('lease_until'),
  watchId:text('watch_id'),
  createdAt:text('created_at').notNull(), updatedAt:text('updated_at').notNull(),
}, t=>[index('jobs_owner_status').on(t.ownerId,t.status,t.createdAt),uniqueIndex('jobs_one_watch_active').on(t.watchId).where(sql`${t.watchId} IS NOT NULL AND ${t.status} IN ('queued','running','waiting_user')`),index('jobs_result_history').on(t.ownerId,t.createdAt).where(sql`${t.resultJson} IS NOT NULL`)]);
export const railMapCache = sqliteTable('rail_map_cache', {
  cacheKey:text('cache_key').primaryKey(), dataJson:text('data_json').notNull(), expiresAt:integer('expires_at').notNull(),
}, t=>[index('rail_map_cache_expiry').on(t.expiresAt)]);
export const railMapLocks = sqliteTable('rail_map_locks', {
  provider:text('provider').primaryKey(), token:text('token').notNull(), untilMs:integer('until_ms').notNull(),
});
export const watches=sqliteTable('watches',{
 id:text('id').primaryKey(),ownerId:text('owner_id').notNull(),name:text('name').notNull(),inputJson:text('input_json').notNull(),
 startAt:text('start_at').notNull(),intervalSeconds:integer('interval_seconds').notNull(),endAt:text('end_at').notNull(),status:text('status').notNull().default('active'),
 stopOnAvailable:integer('stop_on_available').notNull().default(1),nextRunAt:text('next_run_at').notNull(),lastRunAt:text('last_run_at'),lastJobId:text('last_job_id'),
 wasAvailable:integer('was_available').notNull().default(0),message:text('message').notNull().default(''),siteOrigin:text('site_origin').notNull(),createdAt:text('created_at').notNull(),updatedAt:text('updated_at').notNull(),
},t=>[index('watches_due').on(t.status,t.nextRunAt),index('watches_owner').on(t.ownerId,t.createdAt)]);
export const notificationSettings=sqliteTable('notification_settings',{
 ownerId:text('owner_id').primaryKey(),enabled:integer('enabled').notNull().default(0),barkKey:text('bark_key'),updatedAt:text('updated_at').notNull(),
});
export const notificationEvents=sqliteTable('notification_events',{
 id:text('id').primaryKey(),ownerId:text('owner_id').notNull(),eventKey:text('event_key').notNull().unique(),kind:text('kind').notNull(),title:text('title').notNull(),message:text('message').notNull(),url:text('url').notNull(),createdAt:text('created_at').notNull(),
 deliveryStatus:text('delivery_status').notNull().default('pending'),attempts:integer('attempts').notNull().default(0),nextAttemptAt:text('next_attempt_at').notNull(),claimUntil:text('claim_until'),deliveryMessage:text('delivery_message').notNull().default(''),deliveredAt:text('delivered_at'),
},t=>[index('notifications_due').on(t.deliveryStatus,t.nextAttemptAt)]);
export const releasedRunners=sqliteTable('released_runners',{
 deviceId:text('device_id').notNull(),runnerId:text('runner_id').notNull(),releasedAt:text('released_at').notNull(),
},t=>[primaryKey({columns:[t.deviceId,t.runnerId]})]);
export const railMaintenance=sqliteTable('rail_maintenance',{name:text('name').primaryKey(),lastMs:integer('last_ms').notNull()});
