# Plan-mode checks for modules/kms: the CloudFront Origin Access Control statement (T-0048).

mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}

variables {
  name        = "kesher-test-s3"
  description = "test"
}

run "no_cloudfront_by_default" {
  command = plan

  module {
    source = "./modules/kms"
  }

  assert {
    condition     = length([for s in data.aws_iam_policy_document.key.statement : s if s.sid == "CloudFrontOriginAccessControl"]) == 0
    error_message = "CloudFront gets nothing unless a distribution is named"
  }
}

run "named_distribution_may_decrypt_only_through_its_arn" {
  command = plan

  module {
    source = "./modules/kms"
  }

  variables {
    cloudfront_distribution_arns = ["arn:aws:cloudfront::111111111111:distribution/E000000000000"]
  }

  assert {
    condition     = length([for s in data.aws_iam_policy_document.key.statement : s if s.sid == "CloudFrontOriginAccessControl"]) == 1
    error_message = "one CloudFront statement"
  }

  assert {
    condition = alltrue([for s in data.aws_iam_policy_document.key.statement : (
      toset(s.actions) == toset(["kms:Decrypt", "kms:GenerateDataKey*"]) &&
      toset(one(s.principals).identifiers) == toset(["cloudfront.amazonaws.com"]) &&
      one(s.condition).variable == "AWS:SourceArn" && toset(one(s.condition).values) == toset(["arn:aws:cloudfront::111111111111:distribution/E000000000000"])
    ) if s.sid == "CloudFrontOriginAccessControl"])
    error_message = "decrypt and data-key only, for the CloudFront service, conditioned on the distribution ARN"
  }
}
