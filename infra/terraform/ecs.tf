# ECS Fargate: web ×2, api ×2, worker ×1, clamav ×1 (doc 13 §2, §5), plus one-off tasks
# (release on every deploy; nightly backup; weekly restore drill — schedules.tf).

resource "aws_ecs_cluster" "this" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_service_discovery_private_dns_namespace" "this" {
  name = "fin.internal"
  vpc  = aws_vpc.this.id
}

resource "aws_service_discovery_service" "this" {
  for_each = toset(["api", "clamav"])
  name     = each.key
  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.this.id
    routing_policy = "MULTIVALUE"
    dns_records {
      ttl  = 10
      type = "A"
    }
  }
  health_check_custom_config {
    failure_threshold = 1
  }
}

resource "aws_cloudwatch_log_group" "app" {
  for_each          = toset(["web", "api", "worker", "clamav", "ops"])
  name              = "/${local.name}/${each.key}"
  retention_in_days = 180 # CERT-In: 180 days of logs, kept in India ⚖
  kms_key_id        = aws_kms_key.logs.arn
}

# --- IAM: execution role (pull images, read secrets) and task roles (what the code may do) ---

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${local.name}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secrets" {
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = [local.app_secret, local.owner_secret] },
      { Effect = "Allow", Action = ["kms:Decrypt"], Resource = [aws_kms_key.secrets.arn] },
    ]
  })
}

# The app may read/write documents (no delete) — nothing else in AWS.
resource "aws_iam_role" "app" {
  name               = "${local.name}-app"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy" "app" {
  role = aws_iam_role.app.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject"], Resource = "${aws_s3_bucket.documents.arn}/files/*" },
      { Effect = "Allow", Action = ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"], Resource = aws_kms_key.s3.arn },
    ]
  })
}

# Ops tasks (backup, restore drill) may write and read backups — never delete (Object Lock anyway).
resource "aws_iam_role" "ops" {
  name               = "${local.name}-ops"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy" "ops" {
  role = aws_iam_role.ops.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject"], Resource = "${aws_s3_bucket.backups.arn}/*" },
      { Effect = "Allow", Action = ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"], Resource = aws_kms_key.s3.arn },
    ]
  })
}

# --- Task definitions ---

locals {
  api_image = "${aws_ecr_repository.this["api"].repository_url}:${var.image_tag}"
  web_image = "${aws_ecr_repository.this["web"].repository_url}:${var.image_tag}"
  common_env = [
    { name = "NODE_ENV", value = "production" },
    { name = "APP_ORIGIN", value = "https://${var.domain}" },
    { name = "TRUST_PROXY", value = "1" },
    { name = "LOG_FORMAT", value = "json" },
    { name = "CLAMAV_ADDRESS", value = "clamav.fin.internal:3310" },
    { name = "STORAGE_DRIVER", value = "s3" },
    { name = "S3_BUCKET", value = aws_s3_bucket.documents.id },
    { name = "S3_REGION", value = var.region },
    { name = "S3_KMS_KEY_ID", value = aws_kms_key.s3.arn },
    { name = "SMS_PROVIDER", value = "msg91" },
    { name = "WHATSAPP_PROVIDER", value = "meta" },
  ]
  db_env = [
    { name = "DB_HOST", value = aws_db_instance.this.address },
    { name = "DB_NAME", value = "financiers" },
  ]
  app_secrets = [for k in concat(local.secret_keys.app, local.secret_keys.msg) : { name = k, valueFrom = "${local.app_secret}:${k}::" }]
  hardened = {
    readonlyRootFilesystem = true
    user                   = "10001"
    linuxParameters        = { initProcessEnabled = true, capabilities = { drop = ["ALL"] } }
    mountPoints            = [{ sourceVolume = "tmp", containerPath = "/tmp" }]
  }
  logs = { for k, g in aws_cloudwatch_log_group.app : k => { logDriver = "awslogs", options = { "awslogs-group" = g.name, "awslogs-region" = var.region, "awslogs-stream-prefix" = k } } }
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 2048
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.app.arn
  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }
  volume { name = "tmp" }
  container_definitions = jsonencode([merge(local.hardened, {
    name             = "api"
    image            = local.api_image
    essential        = true
    portMappings     = [{ containerPort = 4000, protocol = "tcp" }]
    environment      = concat(local.common_env, [{ name = "WORKERS", value = "false" }])
    secrets          = local.app_secrets
    logConfiguration = local.logs["api"]
    healthCheck      = { command = ["CMD-SHELL", "wget -qO- http://127.0.0.1:4000/api/v1/health || exit 1"], interval = 30, timeout = 5, retries = 3, startPeriod = 30 }
  })])
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${local.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 2048
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.app.arn
  volume { name = "tmp" }
  container_definitions = jsonencode([merge(local.hardened, {
    name             = "worker"
    image            = local.api_image
    essential        = true
    environment      = concat(local.common_env, [{ name = "WORKERS", value = "true" }])
    secrets          = local.app_secrets
    logConfiguration = local.logs["worker"]
  })])
}

resource "aws_ecs_task_definition" "web" {
  family                   = "${local.name}-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  volume { name = "tmp" }
  container_definitions = jsonencode([merge(local.hardened, {
    name             = "web"
    image            = local.web_image
    essential        = true
    portMappings     = [{ containerPort = 3000, protocol = "tcp" }]
    logConfiguration = local.logs["web"]
    mountPoints      = [{ sourceVolume = "tmp", containerPath = "/tmp" }, { sourceVolume = "cache", containerPath = "/app/apps/web/.next/cache" }]
  })])
  volume { name = "cache" }
}

resource "aws_ecs_task_definition" "clamav" {
  family                   = "${local.name}-clamav"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 3072 # signature database needs ~2 GB
  execution_role_arn       = aws_iam_role.execution.arn
  container_definitions = jsonencode([{
    name             = "clamav"
    image            = "clamav/clamav:stable"
    essential        = true
    portMappings     = [{ containerPort = 3310, protocol = "tcp" }]
    logConfiguration = local.logs["clamav"]
    healthCheck      = { command = ["CMD-SHELL", "clamdcheck.sh"], interval = 60, timeout = 10, retries = 5, startPeriod = 300 }
  }])
}

# One-off tasks with the API image, as the schema owner.
resource "aws_ecs_task_definition" "ops" {
  for_each = {
    release = ["node", "dist/ops/release.js"]
    backup  = ["/app/scripts/backup.sh"]
    drill   = ["/app/scripts/restore-drill.sh", "latest"]
  }
  family                   = "${local.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 2048
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.ops.arn
  ephemeral_storage { size_in_gib = 50 }
  volume { name = "tmp" }
  container_definitions = jsonencode([merge(local.hardened, {
    name             = each.key
    image            = local.api_image
    essential        = true
    command          = each.value
    environment      = concat(local.db_env, [{ name = "BACKUP_TARGET", value = "s3://${aws_s3_bucket.backups.id}/postgres" }, { name = "LOG_FORMAT", value = "json" }])
    secrets          = concat(local.owner_secrets, each.key == "release" ? [for k in local.secret_keys.release : { name = k, valueFrom = "${local.app_secret}:${k}::" }] : [])
    logConfiguration = local.logs["ops"]
  })])
}

# --- Services ---

resource "aws_ecs_service" "api" {
  name                               = "api"
  cluster                            = aws_ecs_cluster.this.id
  task_definition                    = aws_ecs_task_definition.api.arn
  desired_count                      = var.api_count
  launch_type                        = "FARGATE"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = 60
  enable_execute_command             = false
  deployment_circuit_breaker {
    enable   = true
    rollback = true # failed health checks roll back automatically (doc 13 §4)
  }
  network_configuration {
    subnets         = aws_subnet.app[*].id
    security_groups = [aws_security_group.app.id]
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 4000
  }
  service_registries {
    registry_arn = aws_service_discovery_service.this["api"].arn
  }
  lifecycle {
    ignore_changes = [task_definition] # the deploy workflow rolls out new revisions
  }
}

resource "aws_ecs_service" "web" {
  name                               = "web"
  cluster                            = aws_ecs_cluster.this.id
  task_definition                    = aws_ecs_task_definition.web.arn
  desired_count                      = var.web_count
  launch_type                        = "FARGATE"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets         = aws_subnet.app[*].id
    security_groups = [aws_security_group.app.id]
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = 3000
  }
  lifecycle {
    ignore_changes = [task_definition] # the deploy workflow rolls out new revisions
  }
}

resource "aws_ecs_service" "worker" {
  name                               = "worker"
  cluster                            = aws_ecs_cluster.this.id
  task_definition                    = aws_ecs_task_definition.worker.arn
  desired_count                      = 1
  launch_type                        = "FARGATE"
  deployment_minimum_healthy_percent = 0 # never two workers at once
  deployment_maximum_percent         = 100
  network_configuration {
    subnets         = aws_subnet.app[*].id
    security_groups = [aws_security_group.app.id]
  }
  lifecycle {
    ignore_changes = [task_definition] # the deploy workflow rolls out new revisions
  }
}

resource "aws_ecs_service" "clamav" {
  name            = "clamav"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.clamav.arn
  desired_count   = 1
  launch_type     = "FARGATE"
  network_configuration {
    subnets         = aws_subnet.app[*].id
    security_groups = [aws_security_group.app.id]
  }
  service_registries {
    registry_arn = aws_service_discovery_service.this["clamav"].arn
  }
  lifecycle {
    ignore_changes = [task_definition] # the deploy workflow rolls out new revisions
  }
}
