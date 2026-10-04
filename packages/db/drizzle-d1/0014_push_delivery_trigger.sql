-- Enqueue only newly committed events for browsers already opted in. No backfill.
CREATE TRIGGER notification_enqueue_push AFTER INSERT ON notification
BEGIN
  INSERT INTO push_delivery (subscription_id, notification_id)
  SELECT subscription.id, NEW.id
  FROM push_subscription AS subscription
  JOIN session ON session.id = subscription.session_id
  WHERE subscription.user_id = NEW.recipient_id
    AND session.expires_at > cast(unixepoch('subsec') * 1000 as integer);
END;
