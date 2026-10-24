# PostgreSQL 16, Multi-AZ, encrypted, PITR 35 days, deletion protection, TLS required,
# automated backups replicated to Hyderabad (doc 14).

resource "aws_db_subnet_group" "this" {
  name       = local.name
  subnet_ids = aws_subnet.data[*].id
}

resource "aws_db_parameter_group" "this" {
  name   = local.name
  family = "postgres16"
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  parameter {
    name  = "log_min_duration_statement"
    value = "1000" # slow queries (> 1 s)
  }
  parameter {
    name  = "idle_in_transaction_session_timeout"
    value = "60000"
  }
  parameter {
    name         = "shared_preload_libraries"
    value        = "pg_stat_statements"
    apply_method = "pending-reboot"
  }
}

resource "aws_db_instance" "this" {
  identifier                            = local.name
  engine                                = "postgres"
  engine_version                        = "16"
  instance_class                        = var.db_instance_class
  allocated_storage                     = var.db_allocated_storage
  max_allocated_storage                 = var.db_allocated_storage * 3
  storage_type                          = "gp3"
  storage_encrypted                     = true
  kms_key_id                            = aws_kms_key.rds.arn
  db_name                               = var.restore_snapshot == null ? "financiers" : null
  snapshot_identifier                   = var.restore_snapshot
  username                              = "fin_owner"
  manage_master_user_password           = true # in Secrets Manager, rotated by RDS
  master_user_secret_kms_key_id         = aws_kms_key.secrets.arn
  multi_az                              = var.env == "production"
  db_subnet_group_name                  = aws_db_subnet_group.this.name
  vpc_security_group_ids                = [aws_security_group.db.id]
  parameter_group_name                  = aws_db_parameter_group.this.name
  publicly_accessible                   = false
  backup_retention_period               = 35
  backup_window                         = "20:30-21:30" # 02:00–03:00 IST
  maintenance_window                    = "sun:21:30-sun:22:30"
  copy_tags_to_snapshot                 = true
  deletion_protection                   = true
  skip_final_snapshot                   = false
  final_snapshot_identifier             = "${local.name}-final"
  auto_minor_version_upgrade            = true
  performance_insights_enabled          = true
  performance_insights_kms_key_id       = aws_kms_key.rds.arn
  performance_insights_retention_period = 7
  enabled_cloudwatch_logs_exports       = ["postgresql"]
  iam_database_authentication_enabled   = false
}

resource "aws_db_instance_automated_backups_replication" "dr" {
  provider               = aws.dr
  source_db_instance_arn = aws_db_instance.this.arn
  kms_key_id             = aws_kms_key.dr.arn
  retention_period       = 14
}
