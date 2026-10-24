# Alerts to email (and SMS — subscribe a phone to the topic) — doc 13 §7, checklist C4.

resource "aws_sns_topic" "alerts" {
  name              = "${local.name}-alerts"
  kms_master_key_id = "alias/aws/sns"
}

resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

locals {
  alb_dim = { LoadBalancer = aws_lb.this.arn_suffix }
}

resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  alarm_name          = "${local.name}-api-5xx"
  alarm_description   = "API returned server errors — check /${local.name}/api logs by requestId"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  dimensions          = merge(local.alb_dim, { TargetGroup = aws_lb_target_group.api.arn_suffix })
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 10
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "api_latency" {
  alarm_name          = "${local.name}-api-p95"
  alarm_description   = "API p95 above 1 s for 15 minutes"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  dimensions          = merge(local.alb_dim, { TargetGroup = aws_lb_target_group.api.arn_suffix })
  extended_statistic  = "p95"
  period              = 300
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "unhealthy" {
  for_each            = { api = aws_lb_target_group.api.arn_suffix, web = aws_lb_target_group.web.arn_suffix }
  alarm_name          = "${local.name}-${each.key}-unhealthy"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  dimensions          = merge(local.alb_dim, { TargetGroup = each.value })
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "db" {
  for_each = {
    cpu     = { metric = "CPUUtilization", threshold = 80, op = "GreaterThanThreshold" }
    storage = { metric = "FreeStorageSpace", threshold = 20 * 1024 * 1024 * 1024, op = "LessThanThreshold" }
    memory  = { metric = "FreeableMemory", threshold = 256 * 1024 * 1024, op = "LessThanThreshold" }
  }
  alarm_name          = "${local.name}-db-${each.key}"
  namespace           = "AWS/RDS"
  metric_name         = each.value.metric
  dimensions          = { DBInstanceIdentifier = aws_db_instance.this.identifier }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = each.value.threshold
  comparison_operator = each.value.op
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# Log-based alarms: the nightly integrity check failing, a backup failing, the restore drill failing.
resource "aws_cloudwatch_log_metric_filter" "ops" {
  for_each = {
    integrity = { group = aws_cloudwatch_log_group.app["worker"].name, pattern = "\"INTEGRITY CHECK FAILED\"" }
    backup    = { group = aws_cloudwatch_log_group.app["ops"].name, pattern = "?\"BACKUP FAILED\" ?\"RESTORE VERIFICATION FAILED\" ?\"pg_dump: error\"" }
  }
  name           = "${local.name}-${each.key}-failed"
  log_group_name = each.value.group
  pattern        = each.value.pattern
  metric_transformation {
    name      = "${each.key}-failed"
    namespace = "Financiers/${var.env}"
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "ops" {
  for_each            = aws_cloudwatch_log_metric_filter.ops
  alarm_name          = "${local.name}-${each.key}-failed"
  alarm_description   = each.key == "integrity" ? "Ledger/audit integrity check failed — follow docs/runbooks/incident-response.md" : "Backup or restore drill failed — follow docs/runbooks/disaster-recovery.md"
  namespace           = "Financiers/${var.env}"
  metric_name         = "${each.key}-failed"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# The nightly backup must have run in the last 26 hours.
resource "aws_cloudwatch_log_metric_filter" "backup_ok" {
  name           = "${local.name}-backup-ok"
  log_group_name = aws_cloudwatch_log_group.app["ops"].name
  pattern        = "\"backup ok\""
  metric_transformation {
    name      = "backup-ok"
    namespace = "Financiers/${var.env}"
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "backup_missing" {
  alarm_name          = "${local.name}-backup-missing"
  alarm_description   = "No successful nightly backup in the last 26 hours"
  namespace           = "Financiers/${var.env}"
  metric_name         = "backup-ok"
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 26
  datapoints_to_alarm = 26
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}
