CREATE TABLE "operator"."inflow_counterparty" (
	"subject_id" text NOT NULL,
	"counterparty" text NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_to_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "inflow_counterparty_subject_id_counterparty_pk" PRIMARY KEY("subject_id","counterparty")
);
--> statement-breakpoint
CREATE TABLE "operator"."inflow_summary" (
	"subject_id" text NOT NULL,
	"month_bucket" text NOT NULL,
	"counterparty_count" integer DEFAULT 0 NOT NULL,
	"total_minor" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inflow_summary_subject_id_month_bucket_pk" PRIMARY KEY("subject_id","month_bucket")
);
--> statement-breakpoint
CREATE INDEX "inflow_counterparty_subject_idx" ON "operator"."inflow_counterparty" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "inflow_summary_subject_idx" ON "operator"."inflow_summary" USING btree ("subject_id");