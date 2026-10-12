CREATE TABLE `field_seasons` (
	`record_key` text PRIMARY KEY NOT NULL,
	`owner_key` text NOT NULL,
	`season_id` text NOT NULL,
	`field_id` text NOT NULL,
	`field_name` text NOT NULL,
	`portion` text NOT NULL,
	`boundary_version` text NOT NULL,
	`harvest_year` integer NOT NULL,
	`crop_code` text NOT NULL,
	`previous_crop_code` text NOT NULL,
	`sowing_date` text NOT NULL,
	`harvest_date` text NOT NULL,
	`payload_json` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `field_seasons_owner_idx` ON `field_seasons` (`owner_key`);--> statement-breakpoint
CREATE INDEX `field_seasons_field_year_idx` ON `field_seasons` (`owner_key`,`field_id`,`harvest_year`);