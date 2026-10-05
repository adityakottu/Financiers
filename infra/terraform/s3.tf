# Documents (KYC, photos, agreements) and backups. Private, KMS-encrypted, versioned, TLS-only.
# Backups use Object Lock (compliance mode) so not even an administrator can delete them early.

resource "aws_s3_bucket" "documents" {
  bucket = "${local.name}-documents-${data.aws_caller_identity.this.account_id}"
}

resource "aws_s3_bucket" "backups" {
  bucket              = "${local.name}-backups-${data.aws_caller_identity.this.account_id}"
  object_lock_enabled = true
}

resource "aws_s3_bucket" "documents_dr" {
  provider = aws.dr
  bucket   = "${local.name}-documents-dr-${data.aws_caller_identity.this.account_id}"
}

locals {
  private_buckets = {
    documents = { id = aws_s3_bucket.documents.id, arn = aws_s3_bucket.documents.arn }
    backups   = { id = aws_s3_bucket.backups.id, arn = aws_s3_bucket.backups.arn }
  }
}

resource "aws_s3_bucket_public_access_block" "this" {
  for_each                = local.private_buckets
  bucket                  = each.value.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "this" {
  for_each = local.private_buckets
  bucket   = each.value.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "this" {
  for_each = local.private_buckets
  bucket   = each.value.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  for_each = local.private_buckets
  bucket   = each.value.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.s3.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_policy" "tls_only" {
  for_each = local.private_buckets
  bucket   = each.value.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [each.value.arn, "${each.value.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
  depends_on = [aws_s3_bucket_public_access_block.this]
}

# Backups: kept at least 35 days whatever happens (compliance mode), then moved to cheaper storage,
# kept 8 years for financial records ⚖ (doc 14, retention to be confirmed).
resource "aws_s3_bucket_object_lock_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    default_retention {
      mode = "COMPLIANCE"
      days = 35
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    id     = "archive"
    status = "Enabled"
    filter {}
    transition {
      days          = 90
      storage_class = "GLACIER_IR"
    }
    expiration {
      days = 2922 # 8 years
    }
    noncurrent_version_expiration {
      noncurrent_days = 2922
    }
  }
}

# Documents are replicated to Hyderabad for regional disaster recovery (doc 14 §3.2).
resource "aws_s3_bucket_versioning" "documents_dr" {
  provider = aws.dr
  bucket   = aws_s3_bucket.documents_dr.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "documents_dr" {
  provider                = aws.dr
  bucket                  = aws_s3_bucket.documents_dr.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "documents_dr" {
  provider = aws.dr
  bucket   = aws_s3_bucket.documents_dr.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.dr.arn
    }
  }
}

resource "aws_iam_role" "replication" {
  name = "${local.name}-s3-replication"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "s3.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy" "replication" {
  role = aws_iam_role.replication.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:GetReplicationConfiguration", "s3:ListBucket"], Resource = aws_s3_bucket.documents.arn },
      { Effect = "Allow", Action = ["s3:GetObjectVersionForReplication", "s3:GetObjectVersionAcl", "s3:GetObjectVersionTagging"], Resource = "${aws_s3_bucket.documents.arn}/*" },
      { Effect = "Allow", Action = ["s3:ReplicateObject", "s3:ReplicateDelete", "s3:ReplicateTags"], Resource = "${aws_s3_bucket.documents_dr.arn}/*" },
      { Effect = "Allow", Action = ["kms:Decrypt"], Resource = aws_kms_key.s3.arn },
      { Effect = "Allow", Action = ["kms:Encrypt", "kms:GenerateDataKey"], Resource = aws_kms_key.dr.arn },
    ]
  })
}

resource "aws_s3_bucket_replication_configuration" "documents" {
  bucket     = aws_s3_bucket.documents.id
  role       = aws_iam_role.replication.arn
  depends_on = [aws_s3_bucket_versioning.this, aws_s3_bucket_versioning.documents_dr]
  rule {
    id     = "dr"
    status = "Enabled"
    filter {}
    delete_marker_replication {
      status = "Disabled"
    }
    source_selection_criteria {
      sse_kms_encrypted_objects {
        status = "Enabled"
      }
    }
    destination {
      bucket = aws_s3_bucket.documents_dr.arn
      encryption_configuration {
        replica_kms_key_id = aws_kms_key.dr.arn
      }
    }
  }
}
