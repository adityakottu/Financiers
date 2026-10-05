variable "env" {
  description = "Environment name: staging or production"
  type        = string
  validation {
    condition     = contains(["staging", "production"], var.env)
    error_message = "env must be staging or production."
  }
}

variable "region" {
  type    = string
  default = "ap-south-1" # Mumbai
}

variable "dr_region" {
  type    = string
  default = "ap-south-2" # Hyderabad
}

variable "domain" {
  description = "Public hostname, e.g. app.example.in (its certificate must be in ACM in var.region)"
  type        = string
}

variable "certificate_arn" {
  description = "ACM certificate for var.domain"
  type        = string
}

variable "image_tag" {
  description = "Image tag to run (set by the deploy workflow)"
  type        = string
  default     = "latest"
}

variable "alert_email" {
  description = "Where alarms are sent (subscribe a phone via SNS SMS as well)"
  type        = string
}

variable "github_repository" {
  description = "owner/repo allowed to deploy through OIDC"
  type        = string
  default     = "adityakottu/Financiers"
}

variable "db_instance_class" {
  type    = string
  default = "db.m7g.large"
}

variable "db_allocated_storage" {
  type    = number
  default = 200
}

variable "api_count" {
  type    = number
  default = 2
}

variable "web_count" {
  type    = number
  default = 2
}

variable "allowed_admin_cidrs" {
  description = "Optional: restrict the whole site to these CIDRs (office IPs) during the pilot. Empty = open to the internet (WAF still applies)."
  type        = list(string)
  default     = []
}

variable "restore_snapshot" {
  description = "Disaster recovery only: build the database from this snapshot ARN (e.g. the cross-region copy). See docs/runbooks/disaster-recovery.md."
  type        = string
  default     = null
}
