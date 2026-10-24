# Application secrets. Terraform creates the container only; the values are put in by hand (or a
# break-glass script) so they never sit in Terraform state:
#   aws secretsmanager put-secret-value --secret-id <arn> --secret-string file://app-secret.json
# with keys: DATABASE_URL (fin_app, sslmode=verify-full), FIN_APP_PASSWORD, DATA_ENCRYPTION_KEY,
# BLIND_INDEX_KEY, SEED_ADMIN_PASSWORD (first deploy only), MSG91_AUTH_KEY, MSG91_SENDER_ID,
# MSG91_WEBHOOK_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN, WHATSAPP_APP_SECRET,
# WHATSAPP_VERIFY_TOKEN. Keep DATA_ENCRYPTION_KEY and BLIND_INDEX_KEY in a sealed envelope as well.
resource "aws_secretsmanager_secret" "app" {
  name                    = "${local.name}/app"
  kms_key_id              = aws_kms_key.secrets.arn
  recovery_window_in_days = 30
}

locals {
  app_secret   = aws_secretsmanager_secret.app.arn
  owner_secret = aws_db_instance.this.master_user_secret[0].secret_arn
  secret_keys = {
    app     = ["DATABASE_URL", "DATA_ENCRYPTION_KEY", "BLIND_INDEX_KEY"]
    msg     = ["MSG91_AUTH_KEY", "MSG91_SENDER_ID", "MSG91_WEBHOOK_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN"]
    release = ["FIN_APP_PASSWORD", "SEED_ADMIN_PASSWORD", "DATA_ENCRYPTION_KEY", "BLIND_INDEX_KEY"]
  }
  # Owner credentials straight from the RDS-managed (rotated) secret.
  owner_secrets = [
    { name = "DB_OWNER_USERNAME", valueFrom = "${local.owner_secret}:username::" },
    { name = "DB_OWNER_PASSWORD", valueFrom = "${local.owner_secret}:password::" },
  ]
}
