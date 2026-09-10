CREATE TABLE "game" (
	"igdb_id" integer PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"hashtag_key" text NOT NULL,
	"name" text NOT NULL,
	"summary" text,
	"cover_media_path" text,
	"cover_image_id" text,
	"first_release_year" integer,
	"genres" text[] DEFAULT '{}'::text[] NOT NULL,
	"platforms" text[] DEFAULT '{}'::text[] NOT NULL,
	"popularity_rank" integer,
	"last_synced_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "game_slug_unique" UNIQUE("slug"),
	CONSTRAINT "game_hashtag_key_unique" UNIQUE("hashtag_key")
);
--> statement-breakpoint
CREATE TABLE "game_favorite" (
	"game_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "game_favorite_game_id_user_id_pk" PRIMARY KEY("game_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "game_favorite" ADD CONSTRAINT "game_favorite_game_id_game_igdb_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."game"("igdb_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_favorite" ADD CONSTRAINT "game_favorite_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "game_favorite_user_created_idx" ON "game_favorite" USING btree ("user_id","created_at" DESC NULLS LAST,"game_id" DESC NULLS LAST);