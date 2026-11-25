-- +goose Up
ALTER TABLE reading_positions ADD COLUMN clicked_css_selector TEXT;
ALTER TABLE reading_positions ADD COLUMN clicked_character_offset INTEGER;
ALTER TABLE reading_positions ADD COLUMN clicked_text_before TEXT;
ALTER TABLE reading_positions ADD COLUMN clicked_text_highlight TEXT;
ALTER TABLE reading_positions ADD COLUMN clicked_text_after TEXT;

-- +goose Down
ALTER TABLE reading_positions DROP COLUMN clicked_text_after;
ALTER TABLE reading_positions DROP COLUMN clicked_text_highlight;
ALTER TABLE reading_positions DROP COLUMN clicked_text_before;
ALTER TABLE reading_positions DROP COLUMN clicked_character_offset;
ALTER TABLE reading_positions DROP COLUMN clicked_css_selector;
