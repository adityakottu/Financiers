terraform {
  required_version = ">= 1.10" # S3 native state locking
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
  }
  # State in S3 (ap-south-1) with locking. Create the bucket once by hand, then:
  #   terraform init -backend-config="bucket=<state-bucket>" -backend-config="key=financiers/<env>.tfstate"
  backend "s3" {
    region       = "ap-south-1"
    encrypt      = true
    use_lockfile = true
  }
}

# Production, backups and DR stay in India (doc 13 ⚖ D6): Mumbai primary, Hyderabad for DR copies.
provider "aws" {
  region = var.region
  default_tags { tags = local.tags }
}

provider "aws" {
  alias  = "dr"
  region = var.dr_region
  default_tags { tags = local.tags }
}
