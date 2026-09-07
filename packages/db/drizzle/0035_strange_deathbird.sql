CREATE TABLE "post_translation" (
	"post_id" uuid NOT NULL,
	"target_locale" text NOT NULL,
	"provider_model" text NOT NULL,
	"translated_content" text,
	"detected_source_locale" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "post_translation_post_id_target_locale_provider_model_pk" PRIMARY KEY("post_id","target_locale","provider_model"),
	CONSTRAINT "post_translation_target_locale" CHECK ("post_translation"."target_locale" in ('en', 'fr')),
	CONSTRAINT "post_translation_detected_source" CHECK ("post_translation"."detected_source_locale" <> '')
);
--> statement-breakpoint
ALTER TABLE "post_translation" ADD CONSTRAINT "post_translation_post_id_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."post"("id") ON DELETE cascade ON UPDATE no action;