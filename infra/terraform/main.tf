locals {
  name = "financiers-${var.env}"
  tags = {
    app         = "financiers"
    env         = var.env
    managed-by  = "terraform"
    data-region = "india"
  }
  azs = slice(data.aws_availability_zones.this.names, 0, 2)
}

data "aws_availability_zones" "this" {
  state = "available"
}

data "aws_caller_identity" "this" {}
