CREATE SCHEMA "operator";
--> statement-breakpoint
CREATE TABLE "operator"."checkout_session" (
	"session_id" text PRIMARY KEY NOT NULL,
	"merchant_id" uuid,
	"merchant" text NOT NULL,
	"state" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"plan_id" text,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operator"."merchant_account" (
	"merchant_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"address" text NOT NULL,
	"environment" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_account_address_unique" UNIQUE("address"),
	CONSTRAINT "merchant_account_environment_check" CHECK ("operator"."merchant_account"."environment" in ('sandbox', 'live'))
);
--> statement-breakpoint
CREATE TABLE "operator"."merchant_api_key" (
	"key_id" text PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"secret_hash" text NOT NULL,
	"last4" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"rotated_from" text,
	CONSTRAINT "merchant_api_key_environment_check" CHECK ("operator"."merchant_api_key"."environment" in ('sandbox', 'live'))
);
--> statement-breakpoint
CREATE TABLE "operator"."merchant_external_ref" (
	"plan_id" text PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operator"."rate_limit_bucket" (
	"key_id" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"tokens" integer NOT NULL,
	"refilled_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_limit_bucket_key_id_window_start_pk" PRIMARY KEY("key_id","window_start")
);
--> statement-breakpoint
CREATE INDEX "checkout_session_merchant_id_idx" ON "operator"."checkout_session" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "checkout_session_expires_at_idx" ON "operator"."checkout_session" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "merchant_api_key_merchant_id_idx" ON "operator"."merchant_api_key" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "merchant_external_ref_merchant_external_idx" ON "operator"."merchant_external_ref" USING btree ("merchant_id","external_id");