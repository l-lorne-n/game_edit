CREATE TYPE "public"."project_version_source" AS ENUM('generate', 'modify', 'debug', 'restore', 'import', 'archive');--> statement-breakpoint
CREATE TABLE "project_versions" (
	"project_id" text NOT NULL,
	"version" integer NOT NULL,
	"source" "project_version_source" NOT NULL,
	"parent_version" integer,
	"restored_from_version" integer,
	"local_snapshot_id" text,
	"evaluator" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_versions_project_id_version_pk" PRIMARY KEY("project_id","version")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"current_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_versions" ADD CONSTRAINT "project_versions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;