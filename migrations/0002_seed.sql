INSERT INTO users (username, password_hash, salt, full_name) VALUES (
  'admin',
  'ee438290bbdeca4918d9247aded2cfb8ac62d9f75b63a6fbd645a040a441cc9d',
  '5532d93a52486c2a4feefb47615f7ed8066d60bf1f5c7aba53d18ec934453a1a',
  'Administrator'
);

INSERT INTO settings (key, value) VALUES
  ('business_name', 'Mukkonz'),
  ('business_address', ''),
  ('business_phone', ''),
  ('business_email', ''),
  ('business_gstin', ''),
  ('invoice_prefix', 'INV'),
  ('order_prefix', 'MK');
