import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";

// Setup Pulumi config values to use later in code
const config = new pulumi.Config();
const dbPassword = config.requireSecret("dbPassword");
const dbUser = config.require("dbUser");

// Create a VPC with public and private subnets
const vpc = new awsx.ec2.Vpc("salamat-a3-vpc", {
    numberOfAvailabilityZones: 2,

    subnetSpecs: [
        { type : "Public" },
        { type : "Private" },
    ],
});

// Create a Security Group (SG) for the EC2 instance
const ec2sg = new aws.ec2.SecurityGroup("ec2-sg", {
    vpcId: vpc.vpcId,
    description: "Allow HTTP, HTTPS, and SSH access",

    ingress: [
        { protocol: "tcp", fromPort: 80, toPort: 80, cidrBlocks: ["0.0.0.0/0"] },
        { protocol: "tcp", fromPort: 443, toPort: 443, cidrBlocks: ["0.0.0.0/0"] },
        { protocol: "tcp", fromPort: 22, toPort: 22, cidrBlocks: ["0.0.0.0/0"] },
    ],

    egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
});

// Create a SG for the RDS instance, allowing ONLY MySQL traffic from EC2
const rdsSg = new aws.ec2.SecurityGroup("rds-sg", {
    vpcId: vpc.vpcId,
    description: "Allow MySQL access from EC2 only",

    ingress: [{
        protocol: "tcp",
        fromPort: 3306,
        toPort: 3306,
        securityGroups: [ec2sg.id],
    }],

    egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
});

// Create a DB Subnet Group for RDS instance using Private Subnets
const dbSubnetGroup = new aws.rds.SubnetGroup("db-subnet-group", {
    subnetIds: vpc.privateSubnetIds,
    tags: { Name: "db-subnet-group" },
});

// Provision RDS MySQL instance
// NOTE: Store sensitive info such as username and password in Pulumi config/secrets
const db = new aws.rds.Instance("salamat-a3db", {
    engine: "mysql",
    instanceClass: "db.t2.micro",
    allocatedStorage: 8,
    dbSubnetGroupName: dbSubnetGroup.name,
    vpcSecurityGroupIds: [rdsSg.id],
    username: dbUser,
    password: dbPassword,       // Replace with Pulumi secret
    dbName: "a3database",
    skipFinalSnapshot: true,
});

// Look up latest Amazon Linux 2 AMI
const ami = aws.ec2.getAmi({
    filters: [
        { name: "name", values: ["amzn2-ami-hvm-*-x86_64-gp2"] },
    ],
    owners: ["137112412989"],     // Amazon's Owner ID
    mostRecent: true,
});

// User data script to install Docker and run specified container
// Pull container image from Docker Hub so that the container can connect to RDS instance
const userData = pulumi.interpolate`#!/bin/bash
sudo yum update -y
sudo amazon-linux-extras install docker -y
sudo usermod -a -G docker ec2-user
## Pause to let RDS become available
sleep 60
docker run -d -p 80:5000 \
    -e DB_HOST=${db.endpoint} \
    -e DB_USER=${dbUser} \
    -e DB_PASSWORD=${dbPassword} \
    -e DB_NAME=a3database \
    salamat4/a3-csci3124:a3-webapp
`;

// Provision EC2 instance in the first Public Subnet
const ec2Instance = new aws.ec2.Instance("salamat-a3webapp-instance", {
    ami: ami.then(ami => ami.id),
    instanceType: "t2.micro",
    vpcSecurityGroupIds: [ec2sg.id],
    userData: userData,
    associatePublicIpAddress: true,
});

// Export the public IP of EC2 instance and RDS endpoint
export const publicIp = ec2Instance.publicIp;
export const dbEndpoint = db.endpoint;