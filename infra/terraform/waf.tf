# AWS WAF on the load balancer: AWS managed rules (common, known bad inputs, SQL injection, IP
# reputation) and a per-IP rate limit. Sign-in has its own, tighter limits in the app.

resource "aws_wafv2_web_acl" "this" {
  name  = local.name
  scope = "REGIONAL"
  default_action {
    allow {}
  }
  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = local.name
    sampled_requests_enabled   = true
  }

  dynamic "rule" {
    for_each = {
      AWSManagedRulesAmazonIpReputationList = 1
      AWSManagedRulesCommonRuleSet          = 2
      AWSManagedRulesKnownBadInputsRuleSet  = 3
      AWSManagedRulesSQLiRuleSet            = 4
    }
    content {
      name     = rule.key
      priority = rule.value
      override_action {
        none {}
      }
      statement {
        managed_rule_group_statement {
          vendor_name = "AWS"
          name        = rule.key
          # Uploads (KYC photos, statements, migration files) are larger than the common rule's 8 KB body check.
          dynamic "rule_action_override" {
            for_each = rule.key == "AWSManagedRulesCommonRuleSet" ? ["SizeRestrictions_BODY"] : []
            content {
              name = rule_action_override.value
              action_to_use {
                count {}
              }
            }
          }
        }
      }
      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = rule.key
        sampled_requests_enabled   = true
      }
    }
  }

  rule {
    name     = "rate-limit-per-ip"
    priority = 10
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = 2000 # per 5 minutes per IP
        aggregate_key_type = "IP"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "rate-limit-per-ip"
      sampled_requests_enabled   = true
    }
  }
}

resource "aws_wafv2_web_acl_association" "this" {
  resource_arn = aws_lb.this.arn
  web_acl_arn  = aws_wafv2_web_acl.this.arn
}
