output "alb_dns_name" {
  description = "Point the domain's DNS (CNAME / alias) here"
  value       = aws_lb.this.dns_name
}

output "ecr_repositories" {
  value = { for k, r in aws_ecr_repository.this : k => r.repository_url }
}

output "app_secret_arn" {
  description = "Put the application secret values here (see secrets.tf)"
  value       = aws_secretsmanager_secret.app.arn
}

output "deploy_role_arn" {
  description = "Set as AWS_DEPLOY_ROLE_ARN in the GitHub environment"
  value       = aws_iam_role.deploy.arn
}

output "cluster" {
  value = aws_ecs_cluster.this.name
}

output "network" {
  description = "For one-off tasks (deploy workflow)"
  value       = { subnets = aws_subnet.app[*].id, security_group = aws_security_group.app.id }
}

output "db_instance" {
  value = aws_db_instance.this.identifier
}

output "buckets" {
  value = { documents = aws_s3_bucket.documents.id, backups = aws_s3_bucket.backups.id, documents_dr = aws_s3_bucket.documents_dr.id }
}
