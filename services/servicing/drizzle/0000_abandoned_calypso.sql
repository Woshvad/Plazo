-- `IF NOT EXISTS` is added by hand and must stay. drizzle-kit emits the bare form,
-- and `services/origination/drizzle/0000_dark_marvel_boy.sql` already creates this
-- schema: two operator services share one Postgres schema (see src/db/schema.ts).
-- Neither migration may depend on the other having been applied first, so whichever
-- runs second finds the schema already there and must not fail on it.
CREATE SCHEMA IF NOT EXISTS "operator";
--> statement-breakpoint
CREATE TABLE "operator"."audit_entry" (
	"seq" bigint PRIMARY KEY NOT NULL,
	"prev_hash" text NOT NULL,
	"entry_hash" text NOT NULL,
	"actor" text NOT NULL,
	"capability" text NOT NULL,
	"subject" text NOT NULL,
	"reason" text NOT NULL,
	"payload" jsonb NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "audit_entry_prev_hash_unique" UNIQUE("prev_hash"),
	CONSTRAINT "audit_entry_entry_hash_unique" UNIQUE("entry_hash")
);
--> statement-breakpoint
CREATE TABLE "operator"."notice_delivery" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"notice_key" text NOT NULL,
	"plan_id" text NOT NULL,
	"kind" text NOT NULL,
	"channel" text NOT NULL,
	"recipient" text NOT NULL,
	"outcome" text NOT NULL,
	"detail" text,
	"sent_at" timestamp with time zone NOT NULL,
	CONSTRAINT "notice_delivery_outcome_check" CHECK ("operator"."notice_delivery"."outcome" in ('sent', 'failed', 'suppressed'))
);
--> statement-breakpoint
CREATE TABLE "operator"."payout_attestation" (
	"plan_id" text NOT NULL,
	"destination_domain" integer NOT NULL,
	"tx_hash" text NOT NULL,
	"message" text,
	"attestation" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"polled_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "payout_attestation_plan_id_destination_domain_pk" PRIMARY KEY("plan_id","destination_domain")
);
--> statement-breakpoint
CREATE TABLE "operator"."webhook_delivery" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"event" text NOT NULL,
	"webhook_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"request_body" text NOT NULL,
	"response_status" integer,
	"response_body_truncated" text,
	"latency_ms" integer,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"replay_of" uuid
);
--> statement-breakpoint
CREATE TABLE "operator"."webhook_endpoint" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"url" text NOT NULL,
	"signing_secrets" text[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	CONSTRAINT "webhook_endpoint_status_check" CHECK ("operator"."webhook_endpoint"."status" in ('active', 'degraded', 'disabled'))
);
--> statement-breakpoint
CREATE INDEX "audit_entry_subject_idx" ON "operator"."audit_entry" USING btree ("subject");--> statement-breakpoint
CREATE INDEX "audit_entry_actor_idx" ON "operator"."audit_entry" USING btree ("actor");--> statement-breakpoint
CREATE INDEX "notice_delivery_plan_id_idx" ON "operator"."notice_delivery" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "notice_delivery_notice_key_idx" ON "operator"."notice_delivery" USING btree ("notice_key");--> statement-breakpoint
CREATE INDEX "payout_attestation_status_idx" ON "operator"."payout_attestation" USING btree ("status");--> statement-breakpoint
CREATE INDEX "payout_attestation_tx_hash_idx" ON "operator"."payout_attestation" USING btree ("tx_hash");--> statement-breakpoint
CREATE INDEX "webhook_delivery_merchant_sent_at_idx" ON "operator"."webhook_delivery" USING btree ("merchant_id","sent_at");--> statement-breakpoint
CREATE INDEX "webhook_delivery_webhook_id_idx" ON "operator"."webhook_delivery" USING btree ("webhook_id");--> statement-breakpoint
CREATE INDEX "webhook_endpoint_merchant_id_idx" ON "operator"."webhook_endpoint" USING btree ("merchant_id");