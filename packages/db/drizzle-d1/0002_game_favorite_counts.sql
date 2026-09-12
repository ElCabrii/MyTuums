-- Keep public counts consistent even when account deletion cascades favorites.
UPDATE game SET favorite_count = (
  SELECT count(*) FROM game_favorite WHERE game_favorite.game_id = game.igdb_id
);
--> statement-breakpoint
CREATE TRIGGER game_favorite_insert_count AFTER INSERT ON game_favorite
BEGIN
  UPDATE game SET favorite_count = favorite_count + 1 WHERE igdb_id = NEW.game_id;
END;
--> statement-breakpoint
CREATE TRIGGER game_favorite_delete_count AFTER DELETE ON game_favorite
BEGIN
  UPDATE game SET favorite_count = favorite_count - 1 WHERE igdb_id = OLD.game_id;
END;
--> statement-breakpoint
CREATE TRIGGER game_favorite_move_count AFTER UPDATE OF game_id ON game_favorite
WHEN OLD.game_id <> NEW.game_id
BEGIN
  UPDATE game SET favorite_count = favorite_count - 1 WHERE igdb_id = OLD.game_id;
  UPDATE game SET favorite_count = favorite_count + 1 WHERE igdb_id = NEW.game_id;
END;
