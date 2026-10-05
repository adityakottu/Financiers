# Separate customer-managed keys per purpose (doc 13 §6), rotated yearly.
resource "aws_kms_key" "rds" {
  description         = "${local.name} RDS"
  enable_key_rotation = true
}

resource "aws_kms_key" "s3" {
  description         = "${local.name} documents and backups"
  enable_key_rotation = true
}

resource "aws_kms_key" "secrets" {
  description         = "${local.name} Secrets Manager"
  enable_key_rotation = true
}

resource "aws_kms_key" "logs" {
  description         = "${local.name} CloudWatch Logs"
  enable_key_rotation = true
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "Account"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.this.account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        Sid       = "CloudWatchLogs"
        Effect    = "Allow"
        Principal = { Service = "logs.${var.region}.amazonaws.com" }
        Action    = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"]
        Resource  = "*"
      },
    ]
  })
}

resource "aws_kms_key" "dr" {
  provider            = aws.dr
  description         = "${local.name} DR copies (Hyderabad)"
  enable_key_rotation = true
}
