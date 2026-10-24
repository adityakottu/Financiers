# Nightly logical backup (01:30 IST) and weekly restore drill (Sunday 05:00 IST) as ECS tasks
# (doc 14 §2, §4). A failed run raises the "ops task failed" alarm (monitoring.tf).

resource "aws_iam_role" "scheduler" {
  name = "${local.name}-scheduler"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "scheduler.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy" "scheduler" {
  role = aws_iam_role.scheduler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["ecs:RunTask"], Resource = [for k in ["backup", "drill"] : "${trimsuffix(aws_ecs_task_definition.ops[k].arn, ":${aws_ecs_task_definition.ops[k].revision}")}:*"] },
      { Effect = "Allow", Action = ["iam:PassRole"], Resource = [aws_iam_role.execution.arn, aws_iam_role.ops.arn] },
    ]
  })
}

resource "aws_scheduler_schedule" "ops" {
  for_each = {
    backup = "cron(30 1 * * ? *)"  # daily 01:30
    drill  = "cron(0 5 ? * SUN *)" # Sundays 05:00
  }
  name                         = "${local.name}-${each.key}"
  schedule_expression          = each.value
  schedule_expression_timezone = "Asia/Kolkata"
  flexible_time_window {
    mode = "OFF"
  }
  target {
    arn      = aws_ecs_cluster.this.arn
    role_arn = aws_iam_role.scheduler.arn
    ecs_parameters {
      task_definition_arn = trimsuffix(aws_ecs_task_definition.ops[each.key].arn, ":${aws_ecs_task_definition.ops[each.key].revision}")
      launch_type         = "FARGATE"
      network_configuration {
        subnets         = aws_subnet.app[*].id
        security_groups = [aws_security_group.app.id]
      }
    }
    retry_policy {
      maximum_retry_attempts = 2
    }
  }
}

# AWS Backup: daily RDS snapshot kept 35 days, copied to a vault in Hyderabad (doc 14 §2).
resource "aws_backup_vault" "primary" {
  name        = local.name
  kms_key_arn = aws_kms_key.rds.arn
}

resource "aws_backup_vault" "dr" {
  provider    = aws.dr
  name        = "${local.name}-dr"
  kms_key_arn = aws_kms_key.dr.arn
}

resource "aws_backup_vault_lock_configuration" "primary" {
  backup_vault_name  = aws_backup_vault.primary.name
  min_retention_days = 35
}

resource "aws_backup_plan" "this" {
  name = local.name
  rule {
    rule_name         = "daily"
    target_vault_name = aws_backup_vault.primary.name
    schedule          = "cron(0 21 * * ? *)" # 02:30 IST
    lifecycle {
      delete_after = 35
    }
    copy_action {
      destination_vault_arn = aws_backup_vault.dr.arn
      lifecycle {
        delete_after = 35
      }
    }
  }
}

resource "aws_iam_role" "backup" {
  name = "${local.name}-aws-backup"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "backup.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "backup" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}

resource "aws_backup_selection" "rds" {
  name         = "rds"
  plan_id      = aws_backup_plan.this.id
  iam_role_arn = aws_iam_role.backup.arn
  resources    = [aws_db_instance.this.arn]
}
