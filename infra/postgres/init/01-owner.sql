-- Local development and CI only. Creates the role that owns the schema and
-- runs migrations, plus the development and test databases.
-- On Neon the project's default role plays the owner part instead.
CREATE ROLE sethu_owner LOGIN CREATEROLE PASSWORD 'sethu_owner_dev';
CREATE DATABASE sethu OWNER sethu_owner;
CREATE DATABASE sethu_test OWNER sethu_owner;
